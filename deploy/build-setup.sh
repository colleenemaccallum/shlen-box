#!/bin/sh
# Builds the one-file server setup script: the template followed by the committed app, compressed.
# Usage (from app/): sh deploy/build-setup.sh > ../deploy/shlen-box-server-setup.txt
set -e
cat deploy/setup-template.sh
git -c safe.directory='*' archive --format=tar HEAD -- . ':!test' ':!deploy' | xz -9e | base64 -w 76
