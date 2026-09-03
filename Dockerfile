# Runtime image for the hosted Streamable HTTP server (dist/http.js).
#
#   docker build -t sheetrender-mcp .
#   docker run --rm -p 8080:8080 -e SHEETRENDER_API_URL=https://sheetrender.com sheetrender-mcp
#
# Deno installs the exactly-pinned dependencies from deno.lock, so npm — and
# npm lifecycle scripts — are never invoked; node is only the runtime. The
# runtime stage carries production dependencies only, built dist/, and runs as
# the unprivileged `node` user the base image ships. Both base images are
# pinned by digest; keep them in step with Dockerfile.dev and the sheetrender
# repo's Dockerfiles. deploy/mcp/Dockerfile in the sheetrender repo mirrors
# these stages against a tagged tarball of this repository — change both.
FROM node:22.23.2-bookworm-slim@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46 AS build
COPY --from=denoland/deno:bin-2.9.4@sha256:25675bd2a125b59bdcfbb6592ec5c332a2bc56e0dabf038184d8b2c6aec45c3b /deno /usr/local/bin/deno
WORKDIR /app
COPY package.json deno.lock ./
RUN deno install --frozen
COPY tsconfig.json ./
COPY src ./src
RUN node node_modules/.bin/tsc -p tsconfig.json

# Production dependencies only. The manifest is rewritten without
# devDependencies; every remaining specifier is an exact version and the
# lockfile still pins the transitive tree, so resolution cannot drift — it
# only shrinks. (--frozen would refuse the rewritten manifest as "out of
# date", which is exactly the change being made.)
FROM build AS deps
RUN node -e 'const fs = require("fs"); const p = JSON.parse(fs.readFileSync("package.json", "utf8")); delete p.devDependencies; delete p.scripts; fs.writeFileSync("package.json", JSON.stringify(p, null, 2));' \
    && rm -rf node_modules \
    && deno install

FROM node:22.23.2-bookworm-slim@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./package.json
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
# No shell wrapper: signals reach node directly, and the entrypoint drains
# in-flight responses on SIGTERM before exiting.
CMD ["node", "dist/http.js"]
