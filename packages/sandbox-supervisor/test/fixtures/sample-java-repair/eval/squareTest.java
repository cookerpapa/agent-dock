public final class squareTest {
    public static void main(String[] args) {
        if (Calculator.square(-4) != 16) throw new AssertionError("square");
        System.out.println("square passed");
    }
}
