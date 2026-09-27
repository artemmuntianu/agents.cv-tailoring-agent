"""`python -m archiver` - the housekeeping sweep. The flow lives in `archiver/run.py`.

Like `scout/`, the package owns this layer, so there is deliberately **no** root
`archiver.py`: a package and a module of the same name in one directory collide, and Python
would hand `import archiver` to the package while the script ran a different file.
`python -m archiver` is unambiguous.
"""

import sys

from archiver.run import main

if __name__ == "__main__":
    sys.exit(main())
