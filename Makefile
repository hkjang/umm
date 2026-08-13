.PHONY: test build web docker release

VERSION := $(shell tr -d '[:space:]' < VERSION)

test:
	go test ./...
	npm --prefix web run lint

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
