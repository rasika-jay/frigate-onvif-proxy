const tcpProxy = require('node-tcp-proxy');
const argparse = require('argparse');
const dgram    = require('dgram');
const xml2js   = require('xml2js');
const uuid     = require('node-uuid');
const logger   = require('simple-node-logger').createSimpleLogger();

const OnvifServer = require('./src/onvif-server');
const MqttBridge  = require('./src/mqtt-bridge');
const { readAndCheckConfig } = require('./src/config-tools');


const parser = new argparse.ArgumentParser({
    description: 'Virtual RTSP to ONVIF proxy'
});

parser.add_argument('config', { help: 'config filename to use', nargs: '?' });

let args = parser.parse_args();

if (args) {
    if (process.env.DEBUG) {
        logger.setLevel('trace');
    }

    if (!args.config) {
        logger.info('Please specifiy a config filename!');
        return -1;
    }

    let config = readAndCheckConfig(logger, args.config)

    const servers = [];
    let proxies = {};
    for (let onvifConfig of config.onvif) {

        let server = new OnvifServer(logger, onvifConfig);

        if (server.getHostname()) {

            logger.info('');
            server.startHttpServer();
            if (process.env.DEBUG)
                server.enableDebugOutput()

            servers.push(server);

            if (onvifConfig.frigate && onvifConfig.frigate.mqtt) {
                const bridge = new MqttBridge(
                    logger,
                    onvifConfig.frigate.camera,
                    onvifConfig.frigate.mqtt,
                    server.getEventService()
                );
                bridge.start();
            }

            if (!proxies[onvifConfig.target.hostname])
                proxies[onvifConfig.target.hostname] = {}

            if (onvifConfig.ports.rtsp && onvifConfig.target.ports.rtsp)
                proxies[onvifConfig.target.hostname][onvifConfig.ports.rtsp] = onvifConfig.target.ports.rtsp;
            if (onvifConfig.ports.snapshot && onvifConfig.target.ports.snapshot)
                proxies[onvifConfig.target.hostname][onvifConfig.ports.snapshot] = onvifConfig.target.ports.snapshot;
        } else {
            logger.error(`Failed to find IP address for MAC address ${onvifConfig.mac}`)
            return -1;
        }
    }

    for (let destinationAddress in proxies) {
        for (let sourcePort in proxies[destinationAddress]) {
            logger.info(`PROXY: ${sourcePort} --> ${destinationAddress}:${proxies[destinationAddress][sourcePort]}`);
            tcpProxy.createProxy(sourcePort, destinationAddress, proxies[destinationAddress][sourcePort]);
        }
    }

    // Single shared WS-Discovery socket. Sends one ProbeMatches containing all
    // cameras so UniFi Protect sees them all from one UDP packet, bypassing the
    // per-macvlan routing issue where individual camera response sockets would
    // use whichever interface the kernel's routing table picks for 192.168.1.0/24.
    let discoveryMsgNo = 0;
    const discoverySocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    discoverySocket.on('error', err => logger.warn(`DISCOVERY: Socket error: ${err.message}`));

    discoverySocket.on('message', (message, remote) => {
        xml2js.parseString(message.toString(), { tagNameProcessors: [xml2js.processors.stripPrefix] }, (err, result) => {
            if (err) return;

            let probeUuid = '', probeType = '';
            try {
                probeUuid = result['Envelope']['Header'][0]['MessageID'][0];
                probeType = result['Envelope']['Body'][0]['Probe'][0]['Types'][0];
                if (typeof probeType === 'object') probeType = probeType._;
            } catch (_) {}

            if (probeType !== '' && !probeType.includes('NetworkVideoTransmitter')) return;

            logger.debug(`DISCOVERY: Probe from ${remote.address}:${remote.port}`);

            // Send one ProbeMatches per camera (separate UDP packets).
            // A combined envelope breaks directed probes: when UniFi Protect
            // unicasts a probe to a specific camera's IP to get its UUID, we
            // must reply with ONLY that camera's ProbeMatch. Bundling all cameras
            // causes Protect to read the first UUID for every camera it probes,
            // making all cameras appear as the same device.
            for (const server of servers) {
                const response = `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
    <SOAP-ENV:Header>
        <wsa:MessageID>uuid:${uuid.v1()}</wsa:MessageID>
        <wsa:RelatesTo>${probeUuid}</wsa:RelatesTo>
        <wsa:To SOAP-ENV:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</wsa:To>
        <wsa:Action SOAP-ENV:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/ProbeMatches</wsa:Action>
        <d:AppSequence SOAP-ENV:mustUnderstand="true" MessageNumber="${discoveryMsgNo++}" InstanceId="1234567890"/>
    </SOAP-ENV:Header>
    <SOAP-ENV:Body>
        <d:ProbeMatches>
${server.getProbeMatchXml()}
        </d:ProbeMatches>
    </SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;
                const buf = Buffer.from(response);
                discoverySocket.send(buf, 0, buf.length, remote.port, remote.address, sendErr => {
                    if (sendErr) logger.warn(`DISCOVERY: Send failed for ${server.getHostname()}: ${sendErr.message}`);
                    else logger.debug(`DISCOVERY: Sent ProbeMatches for ${server.getHostname()} to ${remote.address}:${remote.port}`);
                });
            }
        });
    });

    discoverySocket.bind(3702, () => {
        const joined = new Set();
        for (const server of servers) {
            const iface = server.getHostname();
            if (joined.has(iface)) continue;
            joined.add(iface);
            try {
                discoverySocket.addMembership('239.255.255.250', iface);
            } catch (e) {
                logger.debug(`DISCOVERY: addMembership failed for ${iface}: ${e.message}`);
            }
        }
        logger.info(`DISCOVERY: Listening on :3702 for ${servers.length} cameras`);
    });

    return 0;
}
