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

    // Shared WS-Discovery socket handles multicast probes (scan discovery).
    // Per-camera sockets below handle directed unicast probes during adoption.
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

            // Multicast probes: respond for every camera (one packet each).
            // Directed unicast probes during adoption are handled by per-camera
            // sockets below, which reply with only the probed camera's UUID.
            for (const server of servers) {
                const response = buildDiscoveryResponse(server.getProbeMatchXml(), probeUuid, discoveryMsgNo++);
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

    // Per-camera sockets bound to each camera's IP. Linux prefers a socket bound
    // to a specific IP over 0.0.0.0 for unicast delivery, so directed probes that
    // Protect sends during adoption go here — not to the shared socket — and get
    // back only that camera's UUID. Do NOT call addMembership; multicast stays on
    // the shared socket.
    for (const server of servers) {
        const camSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

        camSocket.on('error', err =>
            logger.debug(`DISCOVERY: Unicast socket error ${server.getHostname()}: ${err.message}`)
        );

        camSocket.on('message', (message, remote) => {
            xml2js.parseString(message.toString(), { tagNameProcessors: [xml2js.processors.stripPrefix] }, (err, result) => {
                if (err) return;
                let probeUuid = '', probeType = '';
                try {
                    probeUuid = result['Envelope']['Header'][0]['MessageID'][0];
                    probeType = result['Envelope']['Body'][0]['Probe'][0]['Types'][0];
                    if (typeof probeType === 'object') probeType = probeType._;
                } catch (_) {}
                if (probeType !== '' && !probeType.includes('NetworkVideoTransmitter')) return;

                logger.debug(`DISCOVERY: Unicast probe to ${server.getHostname()} from ${remote.address}:${remote.port}`);

                const response = buildDiscoveryResponse(server.getProbeMatchXml(), probeUuid, discoveryMsgNo++);
                const buf = Buffer.from(response);
                discoverySocket.send(buf, 0, buf.length, remote.port, remote.address, sendErr => {
                    if (sendErr) logger.warn(`DISCOVERY: Unicast send failed for ${server.getHostname()}: ${sendErr.message}`);
                    else logger.debug(`DISCOVERY: Unicast ProbeMatches for ${server.getHostname()} → ${remote.address}:${remote.port}`);
                });
            });
        });

        camSocket.bind(3702, server.getHostname(), () =>
            logger.debug(`DISCOVERY: Unicast socket bound to ${server.getHostname()}:3702`)
        );
    }

    return 0;
}
