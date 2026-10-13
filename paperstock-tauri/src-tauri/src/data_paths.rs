use std::path::PathBuf;
use std::sync::OnceLock;

/// An explicit directory keeps diagnostics away from the user's library.
/// The same override also enables an ephemeral WebKit data store in lib.rs.
pub fn user_data_dir() -> &'static PathBuf {
    static USER_DATA: OnceLock<PathBuf> = OnceLock::new();
    USER_DATA.get_or_init(|| match std::env::var_os("PAPERSTOCK_DATA_DIR") {
        Some(path) => {
            let path = PathBuf::from(path);
            assert!(
                path.is_absolute(),
                "PAPERSTOCK_DATA_DIR must be an absolute path"
            );
            path
        }
        None => dirs::data_dir()
            .expect("Could not find data directory")
            .join("Paperstock"),
    })
}
