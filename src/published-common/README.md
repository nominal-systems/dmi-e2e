# published-common

The build context docker-compose.yml uses for `DMI_ENGINE_COMMON_DIR` when that variable is unset.
Compose needs a directory there whatever the variable says, and the image builds read this one as
"no dmi-engine-common checkout": each image then installs `@nominal-systems/dmi-engine-common` from
GitHub Packages at the version its lockfile pins, exactly as it would without the variable.

Keep this file the directory's only content. A build refuses a context that holds neither a
`package.json` nor exactly this file, so a `DMI_ENGINE_COMMON_DIR` that points at the wrong
directory fails the build instead of quietly falling back to the published package.
