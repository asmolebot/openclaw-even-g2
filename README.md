# Even G2 OpenClaw Bridge

Local OpenClaw plugin/component for Even G2 smart glasses.

The first version avoids the older community-plugin websocket client path that
broke under the 2026.6.10 gateway protocol change. It exposes a small
plugin-owned HTTP surface instead:

- `GET /even-g2/health`
- `POST /even-g2/v1/chat/completions`

The chat endpoint accepts OpenAI-compatible chat completion JSON and runs the
prompt through `openclaw agent --json` using a persistent glasses session key.
That makes it usable from Even Hub custom AI endpoint settings or any tiny
glasses-side HTTP client.

## Build

```bash
npm install
npm run build
npm test
```

## Install Locally

```bash
openclaw plugins install --link /home/openclaw/asmo/projects/openclaw-even-g2 --force
openclaw plugins enable even-g2
openclaw gateway restart
```

## Configure

Minimal config:

```json
{
  "plugins": {
    "entries": {
      "even-g2": {
        "enabled": true,
        "config": {
          "apiKey": "put-a-random-token-here",
          "sessionKey": "agent:main:even-g2",
          "maxResponseChars": 1800
        }
      }
    }
  }
}
```

Use the endpoint as an OpenAI-compatible base URL:

```text
https://<gateway-host>/even-g2/v1
```

Set the API key to the configured bearer token.

## Even Hub Setup

The simplest client path is Even Hub's Add Agent / custom AI endpoint flow.
Use the plugin route as the endpoint and the configured bearer token as the API
key.

Recommended URL:

```text
https://<gateway-host>/even-g2
```

The plugin accepts both the endpoint root above and the OpenAI-style
`/even-g2/v1/chat/completions` route because Even Hub and third-party clients
do not all agree on whether they append the OpenAI path themselves.

## Smoke Test

```bash
curl -sS http://127.0.0.1:18789/even-g2/health

curl -sS http://127.0.0.1:18789/even-g2/v1/chat/completions \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"model":"openclaw","messages":[{"role":"user","content":"Say pong in three words."}]}'
```
