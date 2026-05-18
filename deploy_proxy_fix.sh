#!/bin/bash
cd /Users/charliephinney/Documents/Claude/pugs-sales
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
git push 2>&1 | tail -3
echo '---'
vercel --prod --yes 2>&1 | tail -8
