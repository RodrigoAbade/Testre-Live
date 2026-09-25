# Testre-Live

Aplicação privada de compartilhamento de tela para pequenos grupos.

## Stack

- Angular
- ASP.NET Core (.NET 8)
- WebRTC
- WebSocket

## Rodar localmente

### Backend

No PowerShell:

```powershell
cd backend
$env:ROOM_PASSWORD="sua-senha-aqui"
dotnet run
```

O backend roda em `http://localhost:8080`.

### Frontend

Em outro terminal:

```powershell
cd frontend
npm install
npm start
```

Abra `http://localhost:4200`.

A senha da sala é definida pela variável de ambiente `ROOM_PASSWORD` e não deve ser enviada ao GitHub.
