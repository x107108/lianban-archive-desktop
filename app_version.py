"""Identity of this installed shared build."""
from pathlib import Path
import json

CHANNEL = "共享版"
VERSION = json.loads(Path(__file__).with_name("VERSION.json").read_text(encoding="utf-8"))["version"]
