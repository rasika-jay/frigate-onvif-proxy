const http = require('http');
const https = require('https');
const xml2js = require('xml2js');
const uuid = require('node-uuid');

const SOAP_NS = `xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:wsa="http://www.w3.org/2005/08/addressing" xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2" xmlns:tev="http://www.onvif.org/ver10/events/wsdl" xmlns:tns1="http://www.onvif.org/ver10/topics" xmlns:tt="http://www.onvif.org/ver10/schema"`;

function soapEnvelope(body) {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<SOAP-ENV:Envelope ${SOAP_NS}>\n  <SOAP-ENV:Body>\n${body}\n  </SOAP-ENV:Body>\n</SOAP-ENV:Envelope>`;
}

// Parse ISO 8601 duration (PT1H, PT60S, PT5M30S) or absolute ISO timestamp
function parseTermination(str) {
    if (!str) return new Date(Date.now() + 3600 * 1000);
    // Absolute timestamp
    if (str.match(/^\d{4}-/)) {
        const d = new Date(str);
        return isNaN(d) ? new Date(Date.now() + 3600 * 1000) : d;
    }
    // Duration: PT#H#M#S
    const m = str.match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/i);
    if (!m) return new Date(Date.now() + 3600 * 1000);
    const days = parseInt(m[1] || 0);
    const hrs  = parseInt(m[2] || 0);
    const mins = parseInt(m[3] || 0);
    const secs = parseFloat(m[4] || 0);
    const ms = ((days * 86400) + (hrs * 3600) + (mins * 60) + secs) * 1000;
    return new Date(Date.now() + (ms || 3600 * 1000));
}

function notificationMessageXml(utcTime, isMotion) {
    return `      <wsnt:NotificationMessage>
        <wsnt:Topic Dialect="http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet">tns1:RuleEngine/MotionRegionDetector/Motion</wsnt:Topic>
        <wsnt:Message>
          <tt:Message UtcTime="${utcTime}" PropertyOperation="Changed">
            <tt:Source>
              <tt:SimpleItem Name="VideoSourceConfigurationToken" Value="video_src_token"/>
              <tt:SimpleItem Name="VideoAnalyticsConfigurationToken" Value="analytics_token"/>
              <tt:SimpleItem Name="Rule" Value="MyMotionDetectorRule"/>
            </tt:Source>
            <tt:Data>
              <tt:SimpleItem Name="IsMotion" Value="${isMotion ? 'true' : 'false'}"/>
            </tt:Data>
          </tt:Message>
        </wsnt:Message>
      </wsnt:NotificationMessage>`;
}

class EventService {
    constructor(logger, hostname, port) {
        this.logger = logger;
        this.hostname = hostname;
        this.port = port;
        this.subscriptions = new Map();
        // Proactively remove expired subscriptions every 5 minutes
        setInterval(() => {
            const now = new Date();
            for (const [subId, sub] of this.subscriptions) {
                if (sub.terminationTime < now) {
                    this.subscriptions.delete(subId);
                    this.logger.debug(`EVENT: Expired subscription removed [${subId}]`);
                }
            }
        }, 5 * 60 * 1000).unref();
    }

    getServiceUrl() {
        return `http://${this.hostname}:${this.port}/onvif/event_service`;
    }

    handleRequest(req, res) {
        const MAX_BODY = 1024 * 1024; // 1 MB — SOAP envelopes are tiny; cap prevents memory exhaustion
        const chunks = [];
        let bodySize = 0;
        let tooLarge = false;
        req.on('data', chunk => {
            bodySize += chunk.length;
            if (bodySize > MAX_BODY) {
                tooLarge = true;
                res.writeHead(413); res.end();
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (tooLarge) return;
            const body = Buffer.concat(chunks).toString();
            // SOAP 1.1 uses SOAPAction HTTP header; SOAP 1.2 puts the action in the
            // Content-Type header as action="…". Fall back to the body element name.
            let action = (req.headers['soapaction'] || '').replace(/"/g, '');
            if (!action) {
                const ctMatch = (req.headers['content-type'] || '').match(/action="([^"]+)"/i);
                if (ctMatch) action = ctMatch[1];
            }
            if (!action) {
                const bodyMatch = body.match(/<[^>]*[Bb]ody[^>]*>\s*<(?:[^:>\s]+:)?(\w+)/);
                if (bodyMatch) action = bodyMatch[1];
            }

            const subIdMatch = req.url.match(/\/onvif\/event_service\/([^?/]+)/);
            const subId = subIdMatch ? subIdMatch[1] : null;

            this.logger.debug(`EVENT: request action="${action}" url=${req.url}`);

            if (action.includes('GetEventProperties')) {
                this._handleGetEventProperties(res);
            } else if (action.includes('CreatePullPointSubscription') && !subId) {
                this._handleCreatePullPointSubscription(body, res);
            } else if (action.includes('Subscribe') && !subId) {
                this._handleSubscribe(body, res);
            } else if (action.includes('PullMessages') && subId) {
                this._handlePullMessages(subId, body, res);
            } else if (action.includes('Renew') && subId) {
                this._handleRenew(subId, body, res);
            } else if (action.includes('Unsubscribe') && subId) {
                this._handleUnsubscribe(subId, res);
            } else {
                this.logger.warn(`EVENT: unknown action="${action}" url=${req.url}`);
                res.writeHead(400, { 'Content-Type': 'text/plain' });
                res.end('Unknown event service action');
            }
        });
    }

    _handleCreatePullPointSubscription(body, res) {
        xml2js.parseString(body, { tagNameProcessors: [xml2js.processors.stripPrefix] }, (err, parsed) => {
            if (err) {
                this.logger.debug(`EVENT: CreatePullPoint parse error: ${err.message}`);
                res.writeHead(400); res.end(); return;
            }

            let terminationStr = 'PT1H';
            try {
                terminationStr = parsed.Envelope.Body[0].CreatePullPointSubscription[0].InitialTerminationTime[0] || 'PT1H';
            } catch (_) {}

            const subId          = uuid.v4();
            const terminationTime = parseTermination(terminationStr);
            this.subscriptions.set(subId, { type: 'pull', queue: [], terminationTime });
            this.logger.info(`EVENT: CreatePullPoint [${subId}] until ${terminationTime.toISOString()}`);

            const now       = new Date();
            const subRefUrl = `http://${this.hostname}:${this.port}/onvif/event_service/${subId}`;
            res.writeHead(200, { 'Content-Type': 'application/soap+xml; charset=utf-8' });
            res.end(soapEnvelope(`    <tev:CreatePullPointSubscriptionResponse>
      <tev:SubscriptionReference>
        <wsa:Address>${subRefUrl}</wsa:Address>
      </tev:SubscriptionReference>
      <wsnt:CurrentTime>${now.toISOString()}</wsnt:CurrentTime>
      <wsnt:TerminationTime>${terminationTime.toISOString()}</wsnt:TerminationTime>
    </tev:CreatePullPointSubscriptionResponse>`));
        });
    }

    _handlePullMessages(subId, body, res) {
        const sub = this.subscriptions.get(subId);
        if (!sub) {
            res.writeHead(404); res.end(); return;
        }

        const now = new Date();
        if (sub.terminationTime < now) {
            this.subscriptions.delete(subId);
            res.writeHead(404); res.end(); return;
        }

        let limit = 10;
        try {
            xml2js.parseString(body, { tagNameProcessors: [xml2js.processors.stripPrefix] }, (err, parsed) => {
                if (!err) limit = parseInt(parsed.Envelope.Body[0].PullMessages[0].MessageLimit[0]) || 10;
            });
        } catch (_) {}

        const events = sub.queue.splice(0, limit);
        this.logger.debug(`EVENT: PullMessages [${subId}] returning ${events.length} event(s)`);

        const messages = events.map(e => notificationMessageXml(e.utcTime, e.isMotion)).join('\n');
        res.writeHead(200, { 'Content-Type': 'application/soap+xml; charset=utf-8' });
        res.end(soapEnvelope(`    <tev:PullMessagesResponse>
      <tev:CurrentTime>${now.toISOString()}</tev:CurrentTime>
      <tev:TerminationTime>${sub.terminationTime.toISOString()}</tev:TerminationTime>
${messages}
    </tev:PullMessagesResponse>`));
    }

    _handleSubscribe(body, res) {
        xml2js.parseString(body, { tagNameProcessors: [xml2js.processors.stripPrefix] }, (err, parsed) => {
            if (err) {
                this.logger.debug(`EVENT: Subscribe parse error: ${err.message}`);
                res.writeHead(400); res.end(); return;
            }

            let consumerUrl = '';
            let terminationStr = 'PT1H';
            try {
                consumerUrl    = parsed.Envelope.Body[0].Subscribe[0].ConsumerReference[0].Address[0];
                terminationStr = parsed.Envelope.Body[0].Subscribe[0].InitialTerminationTime[0];
            } catch (_) {}

            const subId          = uuid.v4();
            const terminationTime = parseTermination(terminationStr);
            this.subscriptions.set(subId, { type: 'push', consumerUrl, terminationTime });
            this.logger.info(`EVENT: Subscribe from ${consumerUrl} until ${terminationTime.toISOString()} [${subId}]`);

            const now        = new Date();
            const subRefUrl  = `http://${this.hostname}:${this.port}/onvif/event_service/${subId}`;
            res.writeHead(200, { 'Content-Type': 'application/soap+xml; charset=utf-8' });
            res.end(soapEnvelope(`    <wsnt:SubscribeResponse>
      <wsnt:SubscriptionReference>
        <wsa:Address>${subRefUrl}</wsa:Address>
      </wsnt:SubscriptionReference>
      <wsnt:CurrentTime>${now.toISOString()}</wsnt:CurrentTime>
      <wsnt:TerminationTime>${terminationTime.toISOString()}</wsnt:TerminationTime>
    </wsnt:SubscribeResponse>`));
        });
    }

    _handleRenew(subId, body, res) {
        const sub = this.subscriptions.get(subId);
        if (!sub) {
            res.writeHead(404); res.end(); return;
        }

        let terminationStr = 'PT1H';
        try {
            xml2js.parseString(body, { tagNameProcessors: [xml2js.processors.stripPrefix] }, (err, parsed) => {
                if (!err) terminationStr = parsed.Envelope.Body[0].Renew[0].TerminationTime[0] || 'PT1H';
            });
        } catch (_) {}

        sub.terminationTime = parseTermination(terminationStr);
        this.logger.debug(`EVENT: Renew [${subId}] until ${sub.terminationTime.toISOString()}`);

        const now = new Date();
        res.writeHead(200, { 'Content-Type': 'application/soap+xml; charset=utf-8' });
        res.end(soapEnvelope(`    <wsnt:RenewResponse>
      <wsnt:TerminationTime>${sub.terminationTime.toISOString()}</wsnt:TerminationTime>
      <wsnt:CurrentTime>${now.toISOString()}</wsnt:CurrentTime>
    </wsnt:RenewResponse>`));
    }

    _handleUnsubscribe(subId, res) {
        this.subscriptions.delete(subId);
        this.logger.debug(`EVENT: Unsubscribe [${subId}]`);
        res.writeHead(200, { 'Content-Type': 'application/soap+xml; charset=utf-8' });
        res.end(soapEnvelope(`    <wsnt:UnsubscribeResponse/>`));
    }

    _handleGetEventProperties(res) {
        res.writeHead(200, { 'Content-Type': 'application/soap+xml; charset=utf-8' });
        res.end(`<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope"
                   xmlns:tev="http://www.onvif.org/ver10/events/wsdl"
                   xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2"
                   xmlns:wstop="http://docs.oasis-open.org/wsn/t-1"
                   xmlns:tns1="http://www.onvif.org/ver10/topics"
                   xmlns:tt="http://www.onvif.org/ver10/schema"
                   xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <SOAP-ENV:Body>
    <tev:GetEventPropertiesResponse>
      <tev:TopicNamespaceLocation>http://www.onvif.org/onvif/ver10/topics/topicns.xml</tev:TopicNamespaceLocation>
      <wsnt:FixedTopicSet>true</wsnt:FixedTopicSet>
      <wstop:TopicSet>
        <tns1:RuleEngine wstop:topic="false">
          <tns1:MotionRegionDetector wstop:topic="false">
            <tns1:Motion wstop:topic="true">
              <tt:MessageDescription IsProperty="true">
                <tt:Source>
                  <tt:SimpleItemDescription Name="VideoSourceConfigurationToken" Type="tt:ReferenceToken"/>
                  <tt:SimpleItemDescription Name="VideoAnalyticsConfigurationToken" Type="tt:ReferenceToken"/>
                  <tt:SimpleItemDescription Name="Rule" Type="xs:string"/>
                </tt:Source>
                <tt:Data>
                  <tt:SimpleItemDescription Name="IsMotion" Type="xs:boolean"/>
                </tt:Data>
              </tt:MessageDescription>
            </tns1:Motion>
          </tns1:MotionRegionDetector>
        </tns1:RuleEngine>
      </wstop:TopicSet>
    </tev:GetEventPropertiesResponse>
  </SOAP-ENV:Body>
</SOAP-ENV:Envelope>`);
    }

    notify(isMotion) {
        const now = new Date();
        for (const [subId, sub] of this.subscriptions) {
            if (sub.terminationTime < now) {
                this.subscriptions.delete(subId);
                continue;
            }
            if (sub.type === 'pull') {
                sub.queue.push({ utcTime: now.toISOString(), isMotion });
                this.logger.debug(`EVENT: Queued isMotion=${isMotion} for pull subscription [${subId}] (queue length: ${sub.queue.length})`);
            } else {
                this._pushNotify(sub.consumerUrl, now.toISOString(), isMotion);
            }
        }
    }

    _pushNotify(consumerUrl, utcTime, isMotion) {
        if (!consumerUrl) return;

        const body = `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope"
                   xmlns:wsa="http://www.w3.org/2005/08/addressing"
                   xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2"
                   xmlns:tns1="http://www.onvif.org/ver10/topics"
                   xmlns:tt="http://www.onvif.org/ver10/schema">
  <SOAP-ENV:Header>
    <wsa:Action>http://docs.oasis-open.org/wsn/bw-2/NotificationConsumer/Notify</wsa:Action>
  </SOAP-ENV:Header>
  <SOAP-ENV:Body>
    <wsnt:Notify>
${notificationMessageXml(utcTime, isMotion)}
    </wsnt:Notify>
  </SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;

        try {
            const parsed = new URL(consumerUrl);
            const proto  = parsed.protocol === 'https:' ? https : http;
            const req = proto.request({
                hostname: parsed.hostname,
                port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                path:     parsed.pathname + (parsed.search || ''),
                method:   'POST',
                headers: {
                    'Content-Type':   'application/soap+xml; charset=utf-8',
                    'Content-Length': Buffer.byteLength(body)
                }
            }, res => res.resume());
            req.on('error', err => this.logger.warn(`EVENT: Notify push failed to ${consumerUrl}: ${err.message}`));
            req.write(body);
            req.end();
            this.logger.debug(`EVENT: Notify pushed to ${consumerUrl} isMotion=${isMotion}`);
        } catch (e) {
            this.logger.debug(`EVENT: Invalid consumer URL '${consumerUrl}': ${e.message}`);
        }
    }
}

module.exports = EventService;
module.exports.parseTermination = parseTermination;
