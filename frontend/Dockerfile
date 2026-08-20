FROM node:16 AS build
WORKDIR /build
COPY main ./main
COPY pc-tool ./pc-tool
COPY text-tool ./text-tool
COPY image-tool ./image-tool
RUN cd main && yarn install --frozen-lockfile && npm run build
RUN cd pc-tool && npm install && npm run build
RUN cd text-tool && npm install && npm run build
RUN cd image-tool && npm install && npm run build

FROM nginx:1.22
COPY --from=build /build/dist/main /usr/share/nginx/html/main
COPY --from=build /build/dist/pc-tool /usr/share/nginx/html/pc-tool
COPY --from=build /build/dist/text-tool /usr/share/nginx/html/text-tool
COPY --from=build /build/dist/image-tool /usr/share/nginx/html/image-tool
