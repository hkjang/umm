# syntax=docker/dockerfile:1.7
FROM node:24-alpine AS web-build
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --ignore-scripts
COPY web/ ./
RUN npm run build

FROM golang:1.26.7-alpine AS go-build
ARG VERSION=dev
WORKDIR /src
RUN apk add --no-cache ca-certificates
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ cmd/
COPY internal/ internal/
COPY migrations/ migrations/
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" -o /out/umm ./cmd/umm

FROM alpine:3.24
ARG VERSION=dev
RUN apk add --no-cache ca-certificates tzdata && addgroup -S umm && adduser -S -G umm -h /app umm
WORKDIR /app
COPY --from=go-build /out/umm /app/umm
COPY --from=web-build /src/web/dist /app/web
USER umm
ENV UMM_HTTP_ADDR=:8080
EXPOSE 8080
LABEL org.opencontainers.image.title="umm" \
      org.opencontainers.image.description="Spatial Thought Memory with Dream Layer" \
      org.opencontainers.image.source="https://github.com/hkjang/umm" \
      org.opencontainers.image.version="${VERSION}"
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD listen="${UMM_HTTP_ADDR:-:8080}"; port="${listen##*:}"; wget -q -O /dev/null "http://127.0.0.1:${port}/healthz" || exit 1
ENTRYPOINT ["/app/umm"]
