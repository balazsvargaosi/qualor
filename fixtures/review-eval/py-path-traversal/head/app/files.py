import os

UPLOAD_DIR = "/srv/shop/uploads"


def read_upload(name):
    path = os.path.join(UPLOAD_DIR, name)
    with open(path, "rb") as handle:
        return handle.read()
