# Run from the root of your clone of https://github.com/yukevindai/hack-or-treat after extracting this zip into it.
git checkout main
git pull
git add -A
git commit -m "R1: shared scaffold, contracts, mirror UI with glitch effects, mock API routes"
git push origin main
Write-Host "Scaffold pushed. Tell the team: pull main, then branch feature/rN-... and work only in your owned files."
