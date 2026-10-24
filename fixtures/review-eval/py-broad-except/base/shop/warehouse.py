class WarehouseClient:
    """Talks to the warehouse system: one call for each stock level."""

    def __init__(self, session):
        self.session = session

    def push(self, sku, quantity):
        response = self.session.put(f"/stock/{sku}", json={"quantity": quantity})
        response.raise_for_status()
