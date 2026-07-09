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
            : null;
        // Track review IDs for which we've fired notify(true), so we can
        // pair them with the correct notify(false) on 'end', and also handle
        // 'update' events that bring in new tracked objects after a 'new'
        // that had no matching objects yet.
        this._activeReviews = new Set();
    }

    start() {
        const host   = this.mqttConfig.host;
        const port   = this.mqttConfig.port || 1883;
        const prefix = this.mqttConfig.topic_prefix || 'frigate';

        this.client = mqtt.connect(`mqtt://${host}:${port}`);

        this.client.on('connect', () => {
            this.logger.info(`MQTT: Connected to ${host}:${port} for camera '${this.frigateCamera}'${this.objects ? ` (filter: ${this.objects.join(', ')})` : ''}`);
            // frigate/reviews fires earlier in the detection lifecycle than
            // frigate/events, giving lower-latency ONVIF notifications.
            this.client.subscribe(`${prefix}/reviews`);
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

    _matchesFilter(objects) {
        if (this.objects) {
            return objects.some(o => this.objects.includes(o.toLowerCase()));
        }
        // No filter — fire for any alert-severity review (tracked objects detected)
        return true;
    }

    _handleMessage(topic, payload, prefix) {
        if (topic !== `${prefix}/reviews`) return;

        let review;
        try {
            review = JSON.parse(payload);
        } catch (e) {
            this.logger.debug(`MQTT: Failed to parse review payload: ${e.message}`);
            return;
        }

        const after = review.after || {};
        if (after.camera !== this.frigateCamera) return;

        const id = after.id;

        if (review.type === 'new' || review.type === 'update') {
            // Only fire for alert-severity (tracked objects present) when no
            // objects filter is configured; with a filter, check the objects list.
            if (after.severity !== 'alert') return;

            const detectedObjects = (after.data && after.data.objects) || [];
            if (!this._matchesFilter(detectedObjects)) return;

            if (!this._activeReviews.has(id)) {
                this._activeReviews.add(id);
                this.logger.info(`MQTT: ${this.frigateCamera} detection start [${detectedObjects.join(', ')}]`);
                this.eventService.notify(true);
            }
        } else if (review.type === 'end') {
            if (this._activeReviews.has(id)) {
                this._activeReviews.delete(id);
                const endObjects = (after.data && after.data.objects) || [];
                this.logger.info(`MQTT: ${this.frigateCamera} detection end [${endObjects.join(', ')}]`);
                this.eventService.notify(false);
            }
        }
    }
};
