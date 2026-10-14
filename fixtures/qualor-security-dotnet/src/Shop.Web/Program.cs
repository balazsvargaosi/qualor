using Shop.Core;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddControllers();
builder.Services.AddSingleton<CustomerLookup>();

var app = builder.Build();
app.MapControllers();
app.Run();
