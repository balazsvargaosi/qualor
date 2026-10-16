using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.SqlClient;

namespace Shop.Api;

[ApiController]
[Route("api/orders")]
public class OrdersController : ControllerBase
{
    private readonly SqlConnection _conn;

    public OrdersController(SqlConnection conn) => _conn = conn;

    [HttpGet]
    public IActionResult Find([FromQuery] string status)
    {
        var bad = new SqlCommand("SELECT * FROM orders WHERE status = '" + status + "'", _conn);
        var good = new SqlCommand("SELECT * FROM orders WHERE status = @status", _conn);
        good.Parameters.AddWithValue("@status", status);
        return Ok(bad.ExecuteScalar() ?? good.ExecuteScalar());
    }
}
