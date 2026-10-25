use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Msg(String),
    #[error("Could not reach the server: {0}")]
    Network(String),
    #[error("The server rejected the API key. Check that it is copied completely.")]
    Unauthorized,
    #[error("Local database problem: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("File problem: {0}")]
    Io(#[from] std::io::Error),
    #[error("Key storage problem: {0}")]
    Keyring(String),
    /// The user pressed Stop. The app shows this quietly, not as a problem.
    #[error("Stopped.")]
    Stopped,
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    pub fn msg(text: impl Into<String>) -> Self {
        Error::Msg(text.into())
    }
}
