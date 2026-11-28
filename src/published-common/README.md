# published-common

The build context docker-compose.yml uses for `DMI_ENGINE_COMMON_DIR` when that variable is unset
or empty. Compose needs a directory there whatever the variable says. What a build does is decided
by whether the variable is set, never by what this directory holds: unset, each image installs
`@nominal-systems/dmi-engine-common` from GitHub Packages at the version its lockfile pins, exactly
as it would without the variable, and anything else in here (a `.DS_Store`, say) is ignored. Set,
the context is the variable's directory, and the build fails unless that is a dmi-engine-common
checkout, so a mistyped path cannot quietly fall back to the published package.
