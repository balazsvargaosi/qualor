from app.files import read_upload


def health(request):
    return {"status": 200, "body": b"ok"}


def download(request):
    name = request.args.get("name", "")
    return {"status": 200, "body": read_upload(name)}
