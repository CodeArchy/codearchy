mod config;
pub mod handlers;
mod models;
use crate::models::User;
use serde::Serialize;

pub fn start(_u: User) {}
