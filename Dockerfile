# Stage 1: run tests — build fails here if any test fails
FROM node:22-alpine AS test
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY src/ src/
COPY test/ test/
RUN npm test

# Stage 2: production image — minimal, no devDependencies, no test files
FROM node:22-alpine AS production
RUN apk add --no-cache --repository=https://dl-cdn.alpinelinux.org/alpine/v3.20/main dhclient
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --production --silent
COPY main.js .
COPY src/ src/
COPY wsdl/ wsdl/
COPY resources/ resources/
CMD ["node", "main.js", "/onvif.yaml"]
