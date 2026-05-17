FROM --platform=linux/amd64 golang:1.25-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN VERSION=$(cat VERSION) && \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -ldflags="-s -w -X main.version=${VERSION}" -o duplicates .

FROM --platform=linux/amd64 alpine:latest
RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY --from=builder /app/duplicates .
EXPOSE 8080
ENV MOUNT_ROOT=/mnt
ENV PORT=8080
CMD ["./duplicates"]
