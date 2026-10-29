#!/bin/sh
# Vercel's ignored build step (vercel.json ignoreCommand): exit 0 skips the
# build, exit 1 runs it. Builds were most of the Vercel bill in October 2026.
#
# Previews never build: one can't be signed into (passkeys belong to
# AUTH_ORIGIN) and shares the live database, and GitHub Actions already tests
# every branch. Production skips a push that only changed docs, tests, or
# tooling, measured from the last deploy that built. Whenever that can't be
# told, it builds: a wasted build costs cents, a skipped one leaves old code
# live.

if [ "$VERCEL_ENV" != "production" ]; then
	echo "Not production ($VERCEL_ENV): skipping the build"
	exit 0
fi

base="$VERCEL_GIT_PREVIOUS_SHA"
if [ -z "$base" ] || ! git cat-file -e "$base^{commit}" 2>/dev/null; then
	echo "No previous deploy to compare with: building"
	exit 1
fi

changed=$(git diff --name-only "$base" HEAD) || {
	echo "Couldn't diff against $base: building"
	exit 1
}
# The same commit again is a redeploy someone asked for, say for a new
# environment variable.
if [ -z "$changed" ]; then
	echo "Redeploying $base: building"
	exit 1
fi

# Paths no deploy reads. Anything else changing means a build.
deploys=$(printf '%s\n' "$changed" | grep -vE \
	-e '\.md$' \
	-e '^(docs|\.claude|\.github|\.vscode|\.githooks|src/test)/' \
	-e '\.(test|fixtures)\.tsx?$' \
	-e '^(vitest\.config\.ts|biome\.json|skills-lock\.json)$' \
	| grep -v '^$')

if [ -z "$deploys" ]; then
	echo "Only docs, tests, or tooling changed since $base: skipping the build"
	exit 0
fi
echo "Building for:"
printf '%s\n' "$deploys" | head -20
exit 1
