using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
        policy.SetIsOriginAllowed(origin =>
              {
                  if (string.IsNullOrWhiteSpace(origin)) return false;
                  if (origin == "http://localhost:4200") return true;
                  var allowedOrigin = Environment.GetEnvironmentVariable("FRONTEND_ORIGIN");
                  return !string.IsNullOrWhiteSpace(allowedOrigin) && origin == allowedOrigin;
              })
              .AllowAnyHeader()
              .AllowAnyMethod()
              .AllowCredentials());
});

var app = builder.Build();
app.UseCors();
app.UseWebSockets();

var roomPassword = Environment.GetEnvironmentVariable("ROOM_PASSWORD") ?? "troque-esta-senha";
var sessions = new ConcurrentDictionary<string, ClientSession>();
var streams = new ConcurrentDictionary<string, StreamInfo>();

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
    sessions[id] = new ClientSession(id, socket);
    Console.WriteLine($"[WS] Cliente conectado: {id} | clientes={sessions.Count}");

    await SendAsync(socket, new { type = "connected", id, streams = streams.Values.ToArray() });
    Console.WriteLine($"[WS] connected enviado para {id} | lives={streams.Count}");

    var buffer = new byte[64 * 1024];

    try
    {
        while (socket.State == WebSocketState.Open)
        {
            var result = await socket.ReceiveAsync(buffer, context.RequestAborted);
            if (result.MessageType == WebSocketMessageType.Close) break;
            if (result.MessageType != WebSocketMessageType.Text) continue;

            var message = Encoding.UTF8.GetString(buffer, 0, result.Count);
            Console.WriteLine($"[WS] Mensagem de {id}: {GetSignalType(message)}");
            await HandleSignalAsync(id, message, sessions, streams);
        }
    }
    catch (OperationCanceledException)
    {
        Console.WriteLine($"[WS] Conexão cancelada: {id}");
    }
    catch (WebSocketException ex)
    {
        Console.WriteLine($"[WS] Erro WebSocket {id}: {ex.Message}");
    }
    catch (JsonException ex)
    {
        Console.WriteLine($"[WS] JSON inválido de {id}: {ex.Message}");
    }
    catch (Exception ex)
    {
        Console.WriteLine($"[WS] Erro inesperado {id}: {ex}");
    }
    finally
    {
        sessions.TryRemove(id, out _);
        Console.WriteLine($"[WS] Cliente desconectado: {id} | clientes={sessions.Count}");

        foreach (var stream in streams.Values.Where(x => x.BroadcasterId == id).ToArray())
        {
            streams.TryRemove(stream.StreamId, out _);
            Console.WriteLine($"[STREAM] Removida por desconexão: {stream.StreamId} ({stream.Name})");
            await BroadcastAsync(sessions, new { type = "stream-stopped", streamId = stream.StreamId, broadcasterId = id });
        }

        if (socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
            await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "closed", CancellationToken.None);
    }
});

app.MapGet("/api/health", () => Results.Ok(new { status = "ok", clients = sessions.Count, streams = streams.Count }));

app.Run("http://0.0.0.0:8080");

static async Task HandleSignalAsync(
    string senderId,
    string rawMessage,
    ConcurrentDictionary<string, ClientSession> sessions,
    ConcurrentDictionary<string, StreamInfo> streams)
{
    using var document = JsonDocument.Parse(rawMessage);
    var root = document.RootElement;
    if (!root.TryGetProperty("type", out var typeElement))
    {
        Console.WriteLine($"[WS] Mensagem sem type recebida de {senderId}");
        return;
    }

    var type = typeElement.GetString();

    if (type == "start-stream")
    {
        var streamId = Guid.NewGuid().ToString("N");
        var name = root.TryGetProperty("name", out var nameElement) && !string.IsNullOrWhiteSpace(nameElement.GetString())
            ? nameElement.GetString()!
            : $"Live {streams.Count + 1}";
        var stream = new StreamInfo(streamId, senderId, name);
        streams[streamId] = stream;
        Console.WriteLine($"[STREAM] Criada: {streamId} | nome={name} | broadcaster={senderId}");
        await BroadcastAsync(sessions, new { type = "stream-started", stream });
        await SendToAsync(sessions, senderId, new { type = "stream-created", stream });
        Console.WriteLine($"[STREAM] stream-created enviado para {senderId}");
        return;
    }

    if (type == "stop-stream" && root.TryGetProperty("streamId", out var stopStreamIdElement))
    {
        var streamId = stopStreamIdElement.GetString();
        if (streamId is not null && streams.TryGetValue(streamId, out var stream) && stream.BroadcasterId == senderId)
        {
            streams.TryRemove(streamId, out _);
            Console.WriteLine($"[STREAM] Encerrada: {streamId} | broadcaster={senderId}");
            await BroadcastAsync(sessions, new { type = "stream-stopped", streamId, broadcasterId = senderId });
        }
        return;
    }

    if (type == "watch" && root.TryGetProperty("streamId", out var watchStreamIdElement))
    {
        var streamId = watchStreamIdElement.GetString();
        if (streamId is not null && streams.TryGetValue(streamId, out var stream))
        {
            Console.WriteLine($"[WEBRTC] watch | stream={streamId} | viewer={senderId} | broadcaster={stream.BroadcasterId}");
            await SendToAsync(sessions, stream.BroadcasterId, new { type = "watch", streamId, viewerId = senderId });
        }
        else
        {
            Console.WriteLine($"[WEBRTC] watch ignorado: stream inexistente {streamId}");
        }
        return;
    }

    if (root.TryGetProperty("targetId", out var targetElement))
    {
        var targetId = targetElement.GetString();
        if (!string.IsNullOrWhiteSpace(targetId))
        {
            Console.WriteLine($"[WEBRTC] {type} | de={senderId} | para={targetId}");
            var payload = new Dictionary<string, object?>();
            foreach (var property in root.EnumerateObject())
                payload[property.Name] = JsonSerializer.Deserialize<object>(property.Value.GetRawText());
            payload["senderId"] = senderId;
            await SendToAsync(sessions, targetId, payload);
        }
        return;
    }

    Console.WriteLine($"[WS] Tipo não tratado: {type} | sender={senderId}");
}

static string GetSignalType(string rawMessage)
{
    try
    {
        using var document = JsonDocument.Parse(rawMessage);
        return document.RootElement.TryGetProperty("type", out var type)
            ? type.GetString() ?? "(type nulo)"
            : "(sem type)";
    }
    catch
    {
        return "(JSON inválido)";
    }
}

static async Task BroadcastAsync(ConcurrentDictionary<string, ClientSession> sessions, object data)
{
    foreach (var session in sessions.Values.Where(x => x.Socket.State == WebSocketState.Open))
        await SendAsync(session.Socket, data);
}

static Task SendToAsync(ConcurrentDictionary<string, ClientSession> sessions, string id, object data)
{
    if (sessions.TryGetValue(id, out var session) && session.Socket.State == WebSocketState.Open)
        return SendAsync(session.Socket, data);

    Console.WriteLine($"[WS] Destino indisponível: {id}");
    return Task.CompletedTask;
}

static Task SendAsync(WebSocket socket, object data) =>
    SendTextAsync(socket, JsonSerializer.Serialize(data));

static Task SendTextAsync(WebSocket socket, string text)
{
    var bytes = Encoding.UTF8.GetBytes(text);
    return socket.SendAsync(bytes, WebSocketMessageType.Text, true, CancellationToken.None);
}

record LoginRequest(string Password);
record ClientSession(string Id, WebSocket Socket);
record StreamInfo(string StreamId, string BroadcasterId, string Name);
