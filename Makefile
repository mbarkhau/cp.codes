.PHONY: help dev start deploy check typegen

help:
	@echo "Targets:"
	@echo "  make dev      - run local webserver (wrangler dev)"
	@echo "  make start    - alias for dev"
	@echo "  make deploy   - deploy to Cloudflare"
	@echo "  make check    - typecheck with tsc"
	@echo "  make typegen  - regenerate worker types"

dev start:
	npm run dev

deploy:
	npm run deploy

check:
	npm run check

typegen:
	npm run cf-typegen
