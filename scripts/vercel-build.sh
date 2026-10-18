#!/bin/sh
# Vercel's build (vercel.json buildCommand). A production deploy applies
# pending migrations before building, so new code never goes live without
# its schema, and a migration that fails stops the deploy. Previews share
# the live database, so they never migrate: an unmerged migration would
# land on live data.
#
# The old deploy keeps serving while this runs, against the new schema.
# Adding is safe; a migration that drops or renames something the old code
# uses needs the coordinated cutover in the README.
set -e

if [ "$VERCEL_ENV" = "production" ]; then
	echo "Applying migrations"
	pnpm db:migrate
else
	echo "Not production ($VERCEL_ENV): skipping migrations"
fi

pnpm build
