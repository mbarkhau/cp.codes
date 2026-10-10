.PHONY: help dev start deploy check typegen clear-db classify classify-paste test test-node test-python test-classify test-moderation

# Read development pastes through the running Wrangler server by default.
BASE_URL ?= http://localhost:8787
PASTE_HOST = $(patsubst %/,%,$(patsubst http://%,%,$(patsubst https://%,%,$(BASE_URL))))
JEV_CLI = uvx deno run --allow-env=DEFAPI_KEY --allow-net="$(PASTE_HOST),api.defapi.org" scripts/classify-pastes.mjs --base-url "$(BASE_URL)"

help:
	@echo "Targets:"
	@echo "  make dev      - run local webserver (wrangler dev)"
	@echo "  make start    - alias for dev"
	@echo "  make deploy   - deploy to Cloudflare"
	@echo "  make check    - typecheck with tsc"
	@echo "  make test     - run Worker/browser-unit/Python CLI/Deno moderation tests (no paid API calls)"
	@echo "  make typegen  - regenerate worker types"
	@echo "  make clear-db - clear all local Wrangler development data"
	@echo "  make classify - classify the latest 20 local pastes with Jev (requires make dev + DEFAPI_KEY)"
	@echo "  make classify-paste PASTE_ID=CP0A1B2C - classify one local paste with Jev"
	@echo "  Override paste server: BASE_URL=https://cp.codes (default: http://localhost:8787)"

dev start:
	npm run dev

deploy:
	npm run deploy

check:
	npm run check

test: test-node test-python test-classify test-moderation

test-node:
	npm run test:node

test-python:
	npm run test:python

test-classify:
	uvx deno test scripts/classify-pastes.test.mjs

test-moderation:
	uvx deno test scripts/automoderation.test.mjs

typegen:
	npm run cf-typegen

clear-db:
	rm -rf .wrangler/state

classify:
	$(JEV_CLI)

classify-paste:
	@test -n "$(PASTE_ID)" || { echo "Usage: make classify-paste PASTE_ID=CP0A1B2C" >&2; exit 1; }
	$(JEV_CLI) "$(PASTE_ID)"
