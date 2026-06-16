const mqtt = require('mqtt');

module.exports = class MqttBridge {
    constructor(logger, frigateCamera, mqttConfig, eventService, objects) {
        this.logger        = logger;
        this.frigateCamera = frigateCamera;
        this.mqttConfig    = mqttConfig;
        this.eventService  = eventService;
        this.client        = null;
        this.objects       = Array.isArray(objects) && objects.length > 0
            ? objects.map(o => String(o).toLowerCase())
            : null;  // null = no filter, fire on all motion/events
    }

    start() {
        const host   = this.mqttConfig.host;
        const port   = this.mqttConfig.port || 1883;
        const prefix = this.mqttConfig.topic_prefix || 'frigate';

        this.client = mqtt.connect(`mqtt://${host}:${port}`);

        this.client.on('connect', () => {
            this.logger.info(`MQTT: Connected to ${host}:${port} for camera '${this.frigateCamera}'${this.objects ? ` (filter: ${this.objects.join(', ')})` : ''}`);
            if (!this.objects)
                this.client.subscribe(`${prefix}/${this.frigateCamera}/motion`);
            this.client.subscribe(`${prefix}/events`);
        });

        this.client.on('message', (topic, payload) => {
            this._handleMessage(topic, payload.toString(), prefix);
        });

        this.client.on('error', err => {
            this.logger.error(`MQTT: Error for camera '${this.frigateCamera}': ${err.message}`);
        });

        this.client.on('reconnect', () => {
            this.logger.debug(`MQTT: Reconnecting for camera '${this.frigateCamera}'`);
        });
    }

    _handleMessage(topic, payload, prefix) {
        const motionTopic = `${prefix}/${this.frigateCamera}/motion`;

        if (topic === motionTopic) {
            const isMotion = payload.trim().toUpperCase() === 'ON';
            this.logger.info(`MQTT: ${this.frigateCamera} motion=${isMotion}`);
            this.eventService.notify(isMotion);
            return;
        }

        if (topic === `${prefix}/events`) {
            try {
                const event = JSON.parse(payload);
                const camera = event.after && event.after.camera;
                if (camera !== this.frigateCamera) return;

                if (event.type === 'new') {
                    const label = (event.after.label || '').toLowerCase();
                    if (this.objects && !this.objects.includes(label)) return;
                    this.logger.info(`MQTT: ${this.frigateCamera} event start (${label})`);
                    this.eventService.notify(true);
                } else if (event.type === 'end') {
                    const label = ((event.before || event.after).label || '').toLowerCase();
                    if (this.objects && !this.objects.includes(label)) return;
                    this.logger.info(`MQTT: ${this.frigateCamera} event end (${label})`);
                    this.eventService.notify(false);
                }
            } catch (e) {
                this.logger.debug(`MQTT: Failed to parse event payload: ${e.message}`);
            }
        }
    }
};
