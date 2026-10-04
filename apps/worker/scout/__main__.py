"""`python -m scout` - the CronJob's command. The flow lives in `apps/worker/scout/run.py`.

The package owns this layer, so there is deliberately **no** root `scout.py`: a package and a
module of the same name in the same directory collide, and Python would hand `import scout` to
the package while the script ran a different module - the kind of split that only shows up
later. `python -m scout` is unambiguous.
"""

import sys

from scout.run import main

if __name__ == "__main__":
    sys.exit(main())
