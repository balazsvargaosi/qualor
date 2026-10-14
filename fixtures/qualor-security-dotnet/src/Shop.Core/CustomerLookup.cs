using System;
using Microsoft.Data.SqlClient;

namespace Shop.Core;

public class CustomerLookup
{
    private const string ConnectionString = "Server=.;Database=Shop;Integrated Security=true;Encrypt=true";

    public int CountByCity(string city)
    {
        using var connection = new SqlConnection(ConnectionString);
        connection.Open();
        var text = "SELECT COUNT(*) FROM Customers WHERE City = '" + city + "'";
        using var command = new SqlCommand(text, connection);
        return Convert.ToInt32(command.ExecuteScalar());
    }

    public int CountByCountry(string country)
    {
        using var connection = new SqlConnection(ConnectionString);
        connection.Open();
        using var command = new SqlCommand("SELECT COUNT(*) FROM Customers WHERE Country = @country", connection);
        command.Parameters.AddWithValue("@country", country);
        return Convert.ToInt32(command.ExecuteScalar());
    }
}
