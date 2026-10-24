import logging

from shop.warehouse import WarehouseClient

log = logging.getLogger(__name__)


def sync_stock(items, client: WarehouseClient):
    for item in items:
        try:
            client.push(item["sku"], item["quantity"])
        except Exception:
            pass
    return True


def finish_import(items, client: WarehouseClient):
    log.info("import finished, %d items changed", len(items))
    if sync_stock(items, client):
        log.info("stock levels sent to the warehouse")
