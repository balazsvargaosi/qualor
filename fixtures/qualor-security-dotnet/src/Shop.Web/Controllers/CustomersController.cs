using System;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.SqlClient;
using Shop.Core;

namespace Shop.Web.Controllers;

[ApiController]
[Route("api/customers")]
public class CustomersController : ControllerBase
{
    private readonly CustomerLookup _lookup;

    public CustomersController(CustomerLookup lookup)
    {
        _lookup = lookup;
    }

    [HttpGet("count")]
    public IActionResult Count([FromQuery] string city)
    {
        var total = _lookup.CountByCity(city);
        return Ok(new { city, total });
    }

    [HttpGet("count-by-country")]
    public IActionResult CountByCountry([FromQuery] string country)
    {
        return Ok(_lookup.CountByCountry(country));
    }

    [HttpGet("exists")]
    public IActionResult Exists([FromQuery] string name)
    {
        using var connection = new SqlConnection("Server=.;Database=Shop;Integrated Security=true;Encrypt=true");
        connection.Open();
        using var command = new SqlCommand("SELECT 1 FROM Customers WHERE Name = '" + name + "'", connection);
        return Ok(command.ExecuteScalar() != null);
    }
}
