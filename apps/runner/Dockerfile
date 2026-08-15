# The runner drives a real Chromium, so it starts from Playwright's own image.
# Installing the browser onto a plain node image means chasing three dozen
# system libraries (libnss3, libatk, libgbm…) that this image already has, and
# the version here is guaranteed to match the Playwright the code imports.
FROM mcr.microsoft.com/playwright:v1.49.1-noble

WORKDIR /app
ENV NODE_ENV=production

# Set before the install, not after: this is the variable npm reads while
# installing playwright, and the image already ships the matching browser.
# Downloading a second copy afterwards is both slow and a different build.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Every workspace manifest, because `npm ci` validates the lockfile against all
# of them — stubbing the web app out makes the lockfile inconsistent and the
# install fails. Copying the manifests alone still keeps the layer cache: a
# code change doesn't reinstall anything.
COPY package.json package-lock.json ./
COPY packages/schema/package.json ./packages/schema/
COPY apps/runner/package.json ./apps/runner/
COPY apps/web/package.json ./apps/web/

# Only the runner's tree is installed. `--omit=dev` is deliberately not used:
# tsx is a devDependency and it is what runs the TypeScript source.
RUN npm ci --workspace @mimic/runner --include-workspace-root

COPY packages/schema ./packages/schema
COPY apps/runner ./apps/runner

# Recordings, runs, screenshots and sandbox billing records. Mount a volume
# here on any host that recycles containers, or every restart starts empty.
ENV RUNNER_STORAGE_DIR=/data/.mimic
VOLUME ["/data"]

ENV RUNNER_HEADLESS=true
EXPOSE 8787

# Hosts inject PORT; config reads it and binds 0.0.0.0.
CMD ["npm", "run", "start", "--workspace", "@mimic/runner"]
