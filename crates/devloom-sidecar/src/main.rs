mod framing;
mod server;
use std::{io, sync::mpsc, thread};
fn main() {
    let (sender, receiver) = mpsc::sync_channel(32);
    thread::spawn(move || {
        let mut input = io::stdin().lock();
        loop {
            match framing::read_frame(&mut input) {
                Ok(Some(value)) => {
                    if sender.send(Ok(value)).is_err() {
                        break;
                    }
                }
                Ok(None) => break,
                Err(_) => {
                    let _ = sender.send(Err(()));
                    break;
                }
            }
        }
    });
    if server::run(receiver, &mut io::stdout().lock()).is_err() {
        eprintln!("transport failure");
    }
}
