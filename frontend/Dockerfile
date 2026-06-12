# syntax=docker/dockerfile:1
# Reuse official image-tool bundle; overlay locally built main, pc-tool & text-tool.
FROM basicai/xtreme1-frontend:v0.9.1 as base

FROM node:16 as build
WORKDIR /build
COPY main ./main
COPY pc-tool ./pc-tool
COPY text-tool ./text-tool
RUN cd main && yarn install --frozen-lockfile && npm run build
RUN cd pc-tool && npm install && npm run build
RUN cd text-tool && npm install && npm run build

FROM base
COPY --from=build /build/dist/main /usr/share/nginx/html
COPY --from=build /build/dist/main /usr/share/nginx/html/main
COPY --from=build /build/dist/pc-tool /usr/share/nginx/html/pc-tool
COPY --from=build /build/dist/text-tool /usr/share/nginx/html/text-tool
