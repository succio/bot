# replicas-engine

## Railway persistence

The app stores users, balances, and Telegram bot state in a JSON file through `lib/store.js`.

For Railway redeployments, add a Railway Volume and mount it at:

```text
/data
```

With that mount present, the app automatically uses:

```text
/data/users.json
```

You can override the location with either:

```text
USERS_DATA_DIR=/data
```

or:

```text
USERS_DATA_FILE=/data/users.json
```

Without a Railway volume or one of those env vars, the app falls back to the local development file:

```text
data/users.json
```
