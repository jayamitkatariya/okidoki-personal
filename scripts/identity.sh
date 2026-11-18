# The app's identity, shared by every script. Its own bundle id, name and executable keep this
# build's permission grants, defaults, data and running process apart from any other okidoki.
OKIDOKI_BUNDLE_ID="${OKIDOKI_BUNDLE_ID:-dev.okidoki.mac}"
OKIDOKI_APP_NAME="${OKIDOKI_APP_NAME:-Okidoki}"
OKIDOKI_EXEC="${OKIDOKI_EXEC:-Okidoki}"

# 0.9.1 and earlier shipped as "Okidoki Personal" (dev.okidoki.personal, executable
# OkidokiPersonal). Those names survive only where a migration or an eval script needs to reach back.
OKIDOKI_LEGACY_BUNDLE_ID="dev.okidoki.personal"
OKIDOKI_LEGACY_APP="/Applications/Okidoki Personal.app"
OKIDOKI_LEGACY_EXEC="OkidokiPersonal"
