use postgres::{Client, Config, NoTls};
use std::str::FromStr;

#[test]
fn direct_connection_to_local_postgres_works() {
    let url = "postgresql://mundusx:mundusx_password@127.0.0.1:5432/mundusx?sslmode=disable";
    let mut config = Config::from_str(url).expect("parse url");
    config.connect_timeout(std::time::Duration::from_secs(10));
    let mut client = config.connect(NoTls).expect("connect with NoTls");
    let row = client
        .query_one("select 1 as ok", &[])
        .expect("execute query");
    let value: i32 = row.get(0);
    assert_eq!(value, 1);
}
