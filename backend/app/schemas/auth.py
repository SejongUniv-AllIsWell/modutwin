from pydantic import BaseModel
from uuid import UUID
from datetime import datetime
from typing import Optional


class AuthCodeExchangeRequest(BaseModel):
    code: str


class SessionResponse(BaseModel):
    token_type: str = "cookie"
    expires_in: int


class UserResponse(BaseModel):
    id: UUID
    email: str
    name: str
    avatar_url: Optional[str] = None
    role: str
    created_at: datetime

    class Config:
        from_attributes = True


class LoginUrlResponse(BaseModel):
    url: str


class WsTicketResponse(BaseModel):
    ticket: str
    expires_in: int
