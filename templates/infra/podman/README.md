# Podman Setup

## Prerequisites

```bash
brew install podman podman-compose
podman machine init
podman machine start
```

## Usage

```bash
podman-compose up -d
podman-compose down
podman-compose logs -f app
```

## Rootless Mode

Podman runs rootless by default. No root privileges needed.
