# The whole demo in one container: console, Fernhill's legacy app, mock PayPal, portal, shop and MCP.
#
#   docker build -t paypal-retrofit https://github.com/Thinkelution/paypal-retrofit.git
#   docker run --rm -p 8787:8787 paypal-retrofit            # then open http://localhost:8787
#
# Your own business instead of the demo (a folder with retrofit.config.yaml, or none for the setup wizard):
#   docker run --rm -p 8787:8787 -v "$PWD:/work" -w /work --env-file .env paypal-retrofit serve
FROM node:22-bookworm AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build /app /app
ENV PORT=8787 RETROFIT_DEMO_DIR=/data
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["node", "/app/packages/cli/bin/paypal-retrofit.js"]
CMD ["demo"]
