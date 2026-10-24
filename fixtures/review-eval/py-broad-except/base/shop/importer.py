import logging

from shop.warehouse import WarehouseClient

log = logging.getLogger(__name__)


def finish_import(items, client: WarehouseClient):
    log.info("import finished, %d items changed", len(items))
