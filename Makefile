.PHONY: test test-go test-web e2e lint build web docker release migrate-dry-run

VERSION := $(shell tr -d '[:space:]' < VERSION)

test: test-go test-web

test-go:
	go vet ./...
	go test ./...

# The frontend gates of the CI verify job, in the order ci.yml runs them, so
# `make test-web` answers the same question CI will. The two that come first
# are the ones whose verdict does not depend on the commit: the dependency
# audit asks a registry that publishes new advisories daily, so a tree that
# was green yesterday fails today without anyone touching it. Leaving the
# audit out of this target is what let GHSA-68fv-2mgg-jv7q (source-map-js,
# high) reach CI unseen — it turned a pull request red for something the
# branch had not changed, and main was equally red. Keep this list in step
# with the Frontend section of .github/workflows/ci.yml; `npm ci` is the one
# step not repeated here, because installing is `make web`'s job and this
# target should not delete a working node_modules.
test-web:
	npm --prefix web run test:offline-queue
	npm --prefix web audit --audit-level=high
	npm --prefix web run typecheck
	npm --prefix web run lint
	node web/scripts/check-i18n.mjs
	npm --prefix web test
	npm --prefix web run build
	npm --prefix web run verify:pwa

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
