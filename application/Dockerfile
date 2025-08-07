FROM alpine AS prebuild
RUN --mount=type=secret,id=candidate,env=CANDIDATE \
    echo $CANDIDATE > wizexercise.txt

# Building the binary of the App
FROM golang:1.19 AS build

WORKDIR /go/src/tasky
COPY . .
RUN go mod download
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /go/src/tasky/tasky


FROM alpine:3.17.0 AS release

WORKDIR /app
COPY --from=build  /go/src/tasky/tasky .
COPY --from=build  /go/src/tasky/assets ./assets

# Copy wizexercise.txt file
COPY --from=prebuild wizexercise.txt .

# Copy the entrypoint script and make it executable
COPY ./entrypoint.sh .
RUN chmod +x entrypoint.sh

EXPOSE 8080
#ENTRYPOINT ["/app/tasky"]
ENTRYPOINT ["/app/entrypoint.sh"]


