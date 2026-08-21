.PHONY: test test-go test-web e2e lint build web docker release migrate-dry-run

VERSION := $(shell tr -d '[:space:]' < VERSION)

test: test-go test-web

test-go:
	go vet ./...
	go test ./...

test-web:
	npm --prefix web run typecheck
	npm --prefix web run lint
	node web/scripts/check-i18n.mjs
	npm --prefix web test

lint:
	npm --prefix web run lint

# Requires POSTGRES_DSN and a built binary; see scripts/multi-instance-smoke.sh
# for the environment the end-to-end suite expects.
e2e: build
	UMM_E2E_COMMAND=$(PWD)/dist/umm npm --prefix web run e2e

# Applies every migration to a scratch database and rolls the reversible ones
# back. Set POSTGRES_CONTAINER when PostgreSQL runs in Docker.
migrate-dry-run:
	./scripts/migrate-dry-run.sh

web:
	npm --prefix web ci
	npm --prefix web run build

build: web
	mkdir -p dist
	go build -trimpath -ldflags="-s -w -X main.version=$(VERSION)" -o dist/umm ./cmd/umm

docker:
	docker build --build-arg VERSION=$(VERSION) -t umm:v$(VERSION) .

release:
	./scripts/release-image.sh $(VERSION)
