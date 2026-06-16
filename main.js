const tcpProxy = require('node-tcp-proxy');
const argparse = require('argparse');
const dgram    = require('dgram');
const xml2js   = require('xml2js');
const uuid     = require('node-uuid');
const logger   = require('simple-node-logger').createSimpleLogger();

const OnvifServer = require('./src/onvif-server');
const MqttBridge  = require('./src/mqtt-bridge');
const { readAndCheckConfig, cleanupInterfaces } = require('./src/config-tools');


const parser = new argparse.ArgumentParser({
    description: 'Frigate ONVIF proxy'
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

    function shutdown() {
        cleanupInterfaces(logger, config);
        process.exit(0);
    }
    process.on('SIGTERM', shutdown);
    process.on('SIGINT',  shutdown);

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

    function buildDiscoveryResponse(probeMatchXml, probeUuid, msgNo) {
        return `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
    <SOAP-ENV:Header>
        <wsa:MessageID>uuid:${uuid.v1()}</wsa:MessageID>
        <wsa:RelatesTo>${probeUuid}</wsa:RelatesTo>
        <wsa:To SOAP-ENV:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</wsa:To>
        <wsa:Action SOAP-ENV:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/ProbeMatches</wsa:Action>
        <d:AppSequence SOAP-ENV:mustUnderstand="true" MessageNumber="${msgNo}" InstanceId="1234567890"/>
    </SOAP-ENV:Header>
    <SOAP-ENV:Body>
        <d:ProbeMatches>
${probeMatchXml}
        </d:ProbeMatches>
    </SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;
    }

    // Per-camera send sockets ensure each ProbeMatches response is sent FROM
    // the camera's own macvlan IP. The kernel routes via that macvlan interface,
    // giving the packet the macvlan's unique Ethernet source MAC. Protect reads
    // this MAC to identify devices; all cameras must have distinct MACs.
    const cameraSendSockets = new Map();
    for (const server of servers) {
        const sock = dgram.createSocket({ type: 'udp4' });
        sock.on('error', err =>
            logger.debug(`DISCOVERY: Send socket error for ${server.getHostname()}: ${err.message}`)
        );
        sock.bind(0, server.getHostname(), () =>
            logger.debug(`DISCOVERY: Send socket bound to ${server.getHostname()}`)
        );
        cameraSendSockets.set(server, sock);
    }

    // Shared WS-Discovery socket receives all multicast probes.
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

            for (const server of servers) {
                const response = buildDiscoveryResponse(server.getProbeMatchXml(), probeUuid, discoveryMsgNo++);
                const buf = Buffer.from(response);
                const sendSock = cameraSendSockets.get(server) || discoverySocket;
                sendSock.send(buf, 0, buf.length, remote.port, remote.address, sendErr => {
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
