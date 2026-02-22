# Local CI with act

Run GitHub Actions locally using [nektos/act](https://github.com/nektos/act).

## Setup

```bash
brew install act
```

## Usage

```bash
act push
act pull_request
act -j build-and-test
```

## Configuration

Create `.actrc` in project root:
```
-P ubuntu-latest=catthehacker/ubuntu:act-latest
--env-file .env.test
```
