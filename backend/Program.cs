using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
        policy.WithOrigins("http://localhost:4200")
              .AllowAnyHeader()
              .AllowAnyMethod()
              .AllowCredentials());
});

var app = builder.Build();
app.UseCors();
app.UseWebSockets();

var roomPassword = Environment.GetEnvironmentVariable("ROOM_PASSWORD") ?? "troque-esta-senha";
var sessions = new ConcurrentDictionary<string, WebSocket>();

app.MapPost("/api/auth", (LoginRequest request) =>
{
    return request.Password == roomPassword
        ? Results.Ok(new { authenticated = true })
        : Results.Unauthorized();
});

app.Map("/ws/signaling", async context =>
{
    if (!context.WebSockets.IsWebSocketRequest)
    {
        context.Response.StatusCode = StatusCodes.Status400BadRequest;
        return;
    }

    var socket = await context.WebSockets.AcceptWebSocketAsync();
    var id = Guid.NewGuid().ToString("N");
    sessions[id] = socket;

    await SendAsync(socket, new { type = "connected", id });

    var buffer = new byte[64 * 1024];

    try
    {
        while (socket.State == WebSocketState.Open)
        {
            var result = await socket.ReceiveAsync(buffer, context.RequestAborted);
            if (result.MessageType == WebSocketMessageType.Close) break;

            var message = Encoding.UTF8.GetString(buffer, 0, result.Count);
            foreach (var peer in sessions.Where(x => x.Key != id && x.Value.State == WebSocketState.Open))
            {
                await SendTextAsync(peer.Value, message);
            }
        }
    }
    catch (OperationCanceledException) { }
    catch (WebSocketException) { }
    finally
    {
        sessions.TryRemove(id, out _);
        foreach (var peer in sessions.Values.Where(x => x.State == WebSocketState.Open))
        {
            await SendAsync(peer, new { type = "peer-left", id });
        }

        if (socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
            await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "closed", CancellationToken.None);
    }
});

app.MapGet("/api/health", () => Results.Ok(new { status = "ok" }));

app.Run("http://0.0.0.0:8080");

static Task SendAsync(WebSocket socket, object data) =>
    SendTextAsync(socket, JsonSerializer.Serialize(data));

static Task SendTextAsync(WebSocket socket, string text)
{
    var bytes = Encoding.UTF8.GetBytes(text);
    return socket.SendAsync(bytes, WebSocketMessageType.Text, true, CancellationToken.None);
}

record LoginRequest(string Password);
