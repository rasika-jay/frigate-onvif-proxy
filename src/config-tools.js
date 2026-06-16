const YAML = require('yaml');
const fs = require('fs');
const { execSync } = require('child_process');

const { getIp4FromMac, generateUUIDv4, generateNetworkMac } = require('./net-tools')


function readConfig(logger, configFile) {

    let configData;
    try {
        configData = fs.readFileSync(configFile, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') {
            logger.info(`File not found: ${configFile}`);
            exit(-1);
        }
        throw error;
    }

    let config;
    try {
        config = YAML.parse(configData);
    } catch (error) {
        logger.info('Failed to read config, invalid yaml syntax.')
        exit(-1);
    }

    return config;
}

function sleep(seconds){
    const spawnSync = require('child_process').spawnSync;
    var sleep = spawnSync('sleep', [seconds]);
}

function readAndCheckConfig(logger, configFile) {

    
    let config = readConfig(logger, configFile);

    let isSaveRequired = false;
    let proxyCounter = 0;
    for (let onvifConfig of config.onvif) {

        //Generate a V4 UUID
        if (!onvifConfig.uuid) {
            let newId = generateUUIDv4();
            logger.info(`CONFIG: UUIDv4 - ${newId}`);
            onvifConfig.uuid = newId;
            isSaveRequired = true;
        }

        // Generate Network MAC for Unicast LAA Prefix
        if (!onvifConfig.mac) {
            let newId = generateNetworkMac();
            logger.info(`CONFIG: MAC - ${newId}`);
            onvifConfig.mac = newId;
            isSaveRequired = true;
        }

        // Parse optional full RTSP URL (e.g. go2rtc) into target.hostname / target.ports.rtsp
        if (onvifConfig.target && onvifConfig.target.rtsp_url) {
            try {
                const parsed = new URL(onvifConfig.target.rtsp_url);
                onvifConfig.target.hostname      = onvifConfig.target.hostname || parsed.hostname;
                if (!onvifConfig.target.ports) onvifConfig.target.ports = {};
                onvifConfig.target.ports.rtsp    = onvifConfig.target.ports.rtsp || (parseInt(parsed.port) || 554);
                onvifConfig.target._rtsp_path    = parsed.pathname;
            } catch (e) {
                logger.warn(`CONFIG: Invalid target.rtsp_url '${onvifConfig.target.rtsp_url}': ${e.message}`);
            }
        }

        if (!getIp4FromMac(logger, onvifConfig.mac)) {
            const vlanName = `rtsp2onvif_${proxyCounter}`;

            // Remove stale interface from a previous run before recreating
            try {
                execSync(`ip link del ${vlanName}`);
                logger.info(`NET_CONF: DEL (cleanup) - ${vlanName}`);
            } catch (_) {}

            logger.info(`NET_CONF: ADD - ${vlanName} MAC: ${onvifConfig.mac}`);
            try {
                const stdout = execSync(`ip link add ${vlanName} link ${onvifConfig.dev} address ${onvifConfig.mac} type macvlan mode bridge`);
                logger.debug(stdout);
            } catch (error) {
                logger.debug(error.message);
            }

            logger.info(`NET_CONF: DHCP - ${vlanName}`);
            try {
                const stdout = execSync(`dhclient ${vlanName}`);
                logger.debug(stdout);
            } catch (error) {
                logger.debug(error.message);
            }

            // logger.info(`NET_CONF: Set ${vlanName} IPv4 ${this.config.ipv4}`)
            // try {
            //     execSync(`ip addr add ${this.config.ipv4} dev ${vlanName}`)
            // } catch (error) {
            //     logger.debug(error.message)
            // }

            // logger.info(`NET_CONF: Set ${vlanName} UP`)
            // try {
            //     execSync(`ip link set ${vlanName} up`)
            // } catch (error) {
            //     logger.debug(error.message)
            // }
        }
        proxyCounter++
    }

    if (isSaveRequired) {
        writeConfig(logger, configFile, config);
        sleep(2);
    }

    return config;
}

function writeConfig(logger, configFile, config) {
    const yamlString = YAML.stringify(config);

    fs.writeFileSync(configFile, yamlString, 'utf8');
    logger.info(`CONFIG: Updated ${configFile}`);
}

module.exports = {
    readAndCheckConfig
}