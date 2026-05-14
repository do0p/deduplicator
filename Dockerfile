FROM golang:1.25-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -ldflags="-s -w" -o duplicates .

FROM alpine:latest
RUN apk add --no-cache ca-certificates && \
    adduser -D -u 1000 app
WORKDIR /app
COPY --from=builder /app/duplicates .
USER app
EXPOSE 8080
ENV MOUNT_ROOT=/mnt
ENV PORT=8080
CMD ["./duplicates"]
